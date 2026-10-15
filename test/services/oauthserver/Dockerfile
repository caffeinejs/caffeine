FROM maven:3-eclipse-temurin-27-alpine@sha256:c31a59d060275be9669d6ed13eb62d7edd66f988aedd2540c35a0640b2224d38 AS builder
WORKDIR /build
COPY pom.xml .
RUN mvn dependency:go-offline -B -q
COPY src ./src
RUN mvn package -DskipTests -B -q

FROM eclipse-temurin:25-jre-alpine@sha256:3c0a9084927a221ccd1d007fcaf614465672c0af37aaa834c5184483afe56d61
WORKDIR /app
COPY --from=builder /build/target/*.jar app.jar
EXPOSE 9000
ENTRYPOINT ["java", "-jar", "app.jar"]

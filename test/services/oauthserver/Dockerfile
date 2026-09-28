FROM maven:3-eclipse-temurin-24-alpine@sha256:1e5a24dab38f3160d404439891ad4fd9b7e14b9e3c5bf65e3a953ba7d6ab4e8e AS builder
WORKDIR /build
COPY pom.xml .
RUN mvn dependency:go-offline -B -q
COPY src ./src
RUN mvn package -DskipTests -B -q

FROM eclipse-temurin:24-jre-alpine@sha256:4044b6c87cb088885bcd0220f7dc7a8a4aab76577605fa471945d2e98270741f
WORKDIR /app
COPY --from=builder /build/target/*.jar app.jar
EXPOSE 9000
ENTRYPOINT ["java", "-jar", "app.jar"]
